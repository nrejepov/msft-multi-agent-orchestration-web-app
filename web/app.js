const form = document.querySelector("#ticket-form");
const input = document.querySelector("#ticket-input");
const sample = document.querySelector("#sample-ticket");
const message = document.querySelector("#form-message");

const initialTickets = [
  "I was charged twice for the same invoice. Can you reverse one payment?",
  "Our webhook requests started returning authentication errors this morning.",
  "Can I export all invoices as a CSV?",
  "Something happened and it is not right. Please fix it.",
];

initialTickets.forEach(addIntakeTicket);

sample.addEventListener("change", () => {
  if (sample.value) {
    input.value = sample.value;
    input.focus();
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const ticket = input.value.trim();
  if (!ticket) return;

  addIntakeTicket(ticket);
  input.value = "";
  sample.value = "";
  setMessage("Ticket added to the General Service Desk.");
});

function addIntakeTicket(ticket) {
  const cards = document.querySelector("#service_desk-cards");
  cards.querySelector(".empty")?.remove();

  const card = document.createElement("article");
  card.className = "ticket-card";
  card.dataset.ticket = ticket;

  const routeButton = element("button", "triage-button");
  routeButton.type = "button";
  routeButton.append(
    element("span", "", "Run multi-agent triage"),
    element("span", "", "→"),
  );
  routeButton.addEventListener("click", () => triageTicket(card, routeButton));

  card.append(
    element("div", "meta", [
      element("span", "team", "Awaiting triage"),
      element("span", "confidence pending", "Unclassified"),
    ]),
    element("p", "ticket-text", ticket),
    routeButton,
  );
  cards.append(card);
  updateCounts();
}

async function triageTicket(card, routeButton) {
  const ticket = card.dataset.ticket;
  routeButton.disabled = true;
  routeButton.querySelector("span:first-child").textContent = "Classifying…";
  setMessage("The Foundry hosted agent is classifying the ticket.");

  try {
    const response = await fetch("api/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.detail || "The ticket could not be classified.");
    }

    card.remove();
    addRoutedTicket(result);
    setMessage(
      `Moved to ${result.team} with ${Math.round(result.confidence * 100)}% confidence.`,
    );
  } catch (error) {
    routeButton.disabled = false;
    routeButton.querySelector("span:first-child").textContent = "Run multi-agent triage";
    setMessage(error.message, true);
  }
  updateCounts();
}

function addRoutedTicket(result) {
  const queue = result.category === "needs_review" ? "service_desk" : result.category;
  const cards = document.querySelector(`#${queue}-cards`);
  if (!cards) throw new Error(`Unknown queue: ${result.category}`);
  cards.querySelector(".empty")?.remove();

  const card = document.createElement("article");
  card.className = "ticket-card routed";
  card.append(
    element("div", "meta", [
      element("span", "team", result.team),
      element("span", "confidence", `${Math.round(result.confidence * 100)}% confidence`),
    ]),
    element("p", "ticket-text", result.ticket),
    detail("Routing reason", result.reason),
    detail("Suggested response", result.response),
  );
  cards.prepend(card);
}

function updateCounts() {
  document.querySelectorAll(".queue").forEach((queue) => {
    const cards = queue.querySelector(".cards");
    const count = cards.querySelectorAll(".ticket-card").length;
    queue.querySelector(".count").textContent = count;
    if (count === 0 && !cards.querySelector(".empty")) {
      cards.append(element("p", "empty", "No tickets in this queue"));
    }
  });
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function detail(label, text) {
  const node = element("p", "detail");
  node.append(element("strong", "", label), document.createTextNode(text));
  return node;
}

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (Array.isArray(content)) node.append(...content);
  else if (content) node.textContent = content;
  return node;
}
