# QPay Support Triage Board

Permanent ticketing-system interface for the Microsoft Agent Framework lab.
Azure Container Registry builds this repository once and Azure Container Apps
runs it using a managed identity.

This repository intentionally contains no agent prompts, routing logic, or lab
solution. Its small FastAPI relay authenticates to the student's Foundry hosted
agent and forwards ticket text to that agent's Responses endpoint. The browser
then moves the ticket to the department returned by the student implementation.

The ARM template supplies these settings:

- `FOUNDRY_PROJECT_ENDPOINT`
- `FOUNDRY_AGENT_NAME` (defaults to `qpay-customer-support`)
- `AZURE_TABLE_ENDPOINT` and `AZURE_TABLE_NAME`
- request, ticket, and input-length limits

Until the student deploys the named hosted agent, tickets remain in the General
Service Desk queue and the relay returns an explanatory message.
