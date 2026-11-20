"""QPay ticket board and authenticated relay to a Foundry hosted agent."""

import asyncio
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import httpx
import uvicorn
from azure.core.exceptions import ResourceNotFoundError
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import DefaultAzureCredential
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError


WEB_DIR = Path(__file__).parent / "web"
MAX_TICKETS = int(os.getenv("MAX_TICKETS", "50"))
RATE_LIMIT_REQUESTS = int(os.getenv("RATE_LIMIT_REQUESTS", "5"))
MAX_TICKET_LENGTH = int(os.getenv("MAX_TICKET_LENGTH", "2000"))
FOUNDRY_PROJECT_ENDPOINT = os.environ["FOUNDRY_PROJECT_ENDPOINT"].rstrip("/")
FOUNDRY_AGENT_NAME = os.getenv("FOUNDRY_AGENT_NAME", "qpay-customer-support")
FOUNDRY_API_VERSION = os.getenv("FOUNDRY_API_VERSION", "v1")

app = FastAPI(title="QPay Support Triage Board")
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


class TicketRequest(BaseModel):
    ticket: str = Field(min_length=3, max_length=MAX_TICKET_LENGTH)


class AgentResult(BaseModel):
    """The contract implemented by the student's hosted agent."""

    category: Literal["billing", "technical", "general", "needs_review"]
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(min_length=1, max_length=500)
    response: str = Field(min_length=1, max_length=4000)


TEAM_NAMES = {
    "billing": "Billing Team",
    "technical": "Technical/API Team",
    "general": "Product Support Team",
    "needs_review": "General Service Desk Team",
}


class UsageGuard:
    """Enforce lab-wide ticket and per-minute request limits."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._local_total = 0
        self._local_minute = ""
        self._local_minute_count = 0
        endpoint = os.getenv("AZURE_TABLE_ENDPOINT")
        self._table = None
        if endpoint:
            service = TableServiceClient(
                endpoint=endpoint,
                credential=DefaultAzureCredential(),
                retry_total=0,
            )
            self._table = service.get_table_client(
                os.getenv("AZURE_TABLE_NAME", "LabUsage")
            )

    @staticmethod
    def _minute_key() -> str:
        return datetime.now(UTC).strftime("%Y%m%d%H%M")

    def _read_count(self, row_key: str) -> int:
        try:
            entity = self._table.get_entity("limits", row_key)
            return int(entity.get("count", 0))
        except ResourceNotFoundError:
            return 0

    def _write_count(self, row_key: str, count: int) -> None:
        self._table.upsert_entity(
            {"PartitionKey": "limits", "RowKey": row_key, "count": count},
            mode=UpdateMode.REPLACE,
        )

    def _consume_table(self, minute_key: str) -> None:
        minute_count = self._read_count(f"minute-{minute_key}")
        if minute_count >= RATE_LIMIT_REQUESTS:
            raise HTTPException(
                status_code=429,
                detail=f"Maximum {RATE_LIMIT_REQUESTS} submissions per minute reached.",
            )
        total_count = self._read_count("total")
        if total_count >= MAX_TICKETS:
            raise HTTPException(
                status_code=429,
                detail=f"This lab has reached its {MAX_TICKETS}-ticket limit.",
            )
        self._write_count(f"minute-{minute_key}", minute_count + 1)
        self._write_count("total", total_count + 1)

    def _consume_local(self, minute_key: str) -> None:
        if minute_key != self._local_minute:
            self._local_minute = minute_key
            self._local_minute_count = 0
        if self._local_minute_count >= RATE_LIMIT_REQUESTS:
            raise HTTPException(
                status_code=429,
                detail=f"Maximum {RATE_LIMIT_REQUESTS} submissions per minute reached.",
            )
        if self._local_total >= MAX_TICKETS:
            raise HTTPException(
                status_code=429,
                detail=f"This lab has reached its {MAX_TICKETS}-ticket limit.",
            )
        self._local_minute_count += 1
        self._local_total += 1

    async def consume(self) -> None:
        """Consume one ticket allowance or reject the request."""
        async with self._lock:
            minute_key = self._minute_key()
            if self._table is None:
                self._consume_local(minute_key)
            else:
                await asyncio.to_thread(self._consume_table, minute_key)


class FoundryRelay:
    """Invoke the student's hosted agent without containing agent logic."""

    def __init__(self) -> None:
        self._credential = DefaultAzureCredential()
        agent_name = quote(FOUNDRY_AGENT_NAME, safe="")
        self._url = (
            f"{FOUNDRY_PROJECT_ENDPOINT}/agents/{agent_name}/endpoint/"
            "protocols/openai/responses"
        )

    @staticmethod
    def _output_text(payload: dict) -> str:
        for output in payload.get("output", []):
            if output.get("type") != "message":
                continue
            for content in output.get("content", []):
                if content.get("type") == "output_text" and content.get("text"):
                    return content["text"]
        raise ValueError("The hosted agent did not return an output message.")

    @staticmethod
    def _parse_result(text: str) -> AgentResult:
        candidate = text.strip()
        if candidate.startswith("```"):
            first_newline = candidate.find("\n")
            candidate = candidate[first_newline + 1 :]
            if candidate.endswith("```"):
                candidate = candidate[:-3]
        first_brace = candidate.find("{")
        last_brace = candidate.rfind("}")
        if first_brace < 0 or last_brace < first_brace:
            raise ValueError("The hosted agent response was not a JSON object.")
        return AgentResult.model_validate(
            json.loads(candidate[first_brace : last_brace + 1])
        )

    async def route(self, ticket: str) -> dict:
        token = await asyncio.to_thread(
            self._credential.get_token,
            "https://ai.azure.com/.default",
        )
        try:
            async with httpx.AsyncClient(timeout=90, follow_redirects=False) as client:
                response = await client.post(
                    self._url,
                    params={"api-version": FOUNDRY_API_VERSION},
                    headers={
                        "Authorization": f"Bearer {token.token}",
                        "Content-Type": "application/json",
                    },
                    json={"input": ticket, "stream": False, "store": False},
                )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=502,
                detail="The Foundry hosted agent could not be reached.",
            ) from exc

        if response.status_code == 404:
            raise HTTPException(
                status_code=503,
                detail=(
                    f"Hosted agent '{FOUNDRY_AGENT_NAME}' is not deployed yet. "
                    "Complete the agent implementation and deploy it to Foundry."
                ),
            )
        if response.is_error:
            raise HTTPException(
                status_code=502,
                detail=f"Foundry rejected the request with status {response.status_code}.",
            )

        try:
            result = self._parse_result(self._output_text(response.json()))
        except (json.JSONDecodeError, ValidationError, ValueError) as exc:
            raise HTTPException(
                status_code=502,
                detail=(
                    "The hosted agent returned an invalid routing result. "
                    "Check the required structured-output fields."
                ),
            ) from exc

        return {
            "ticket": ticket,
            "category": result.category,
            "confidence": result.confidence,
            "reason": result.reason,
            "response": result.response,
            "team": TEAM_NAMES[result.category],
        }


usage_guard = UsageGuard()
foundry_relay = FoundryRelay()


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health", include_in_schema=False)
async def health() -> dict:
    return {"status": "ok", "agent": FOUNDRY_AGENT_NAME}


@app.post("/api/tickets")
async def route_ticket(request: TicketRequest) -> dict:
    await usage_guard.consume()
    return await foundry_relay.route(request.ticket)


if __name__ == "__main__":
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("DASHBOARD_PORT", "8080")),
    )
