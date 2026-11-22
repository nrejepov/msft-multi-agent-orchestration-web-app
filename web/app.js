const tickets = [
  {
    id: "QP-1042",
    reporter: "Maya C",
    date: "04 Nov",
    message: "I was charged twice for the same invoice. Can one payment be reversed?",
  },
  {
    id: "QP-1047",
    reporter: "Leo M",
    date: "06 Nov",
    message: "A refund shows as completed, but it has not reached my customer.",
  },
  {
    id: "QP-1051",
    reporter: "Nadia O",
    date: "08 Nov",
    message: "The payout amount is lower than the balance shown in my account.",
  },
  {
    id: "QP-1058",
    reporter: "Owen P",
    date: "10 Nov",
    message: "Webhook requests started returning authentication errors this morning.",
  },
  {
    id: "QP-1063",
    reporter: "Sofia R",
    date: "11 Nov",
    message: "The customers endpoint returns 403 even though the token is still valid.",
  },
  {
    id: "QP-1069",
    reporter: "Ethan B",
    date: "13 Nov",
    message: "Our SDK integration fails when we create an invoice with tax lines.",
  },
  {
    id: "QP-1074",
    reporter: "Amara S",
    date: "15 Nov",
    message: "How many days of annual leave can I carry into next year?",
  },
  {
    id: "QP-1080",
    reporter: "Jonas M",
    date: "17 Nov",
    message: "Where can I find the parental leave policy and who approves my request?",
  },
  {
    id: "QP-1086",
    reporter: "Priya N",
    date: "19 Nov",
    message: "How do I update my emergency contact details with People Operations?",
  },
  {
    id: "QP-1091",
    reporter: "Noah W",
    date: "21 Nov",
    message: "Something is wrong with my account and I need someone to look at it.",
  },
];

const simulateButton = document.querySelector("#simulate-button");
const resetButton = document.querySelector("#reset-button");
const template = document.querySelector("#ticket-template");
const activityMessage = document.querySelector("#activity-message");
const progressLabel = document.querySelector("#progress-label");
const progressBar = document.querySelector("#progress-bar");
const totalCount = document.querySelector("#total-count");
const generationPanel = document.querySelector("#generation-panel");
const generationLabel = document.querySelector("#generation-label");
const generationDetail = document.querySelector("#generation-detail");
const generationTyped = document.querySelector("#generation-typed");
const foundryFlow = document.querySelector("#foundry-flow");
const flowStatus = document.querySelector("#flow-status");
const flowDetail = document.querySelector("#flow-detail");
const notification = document.querySelector("#routing-notification");
const notificationMessage = document.querySelector("#notification-message");

let ticketOrder = shuffle([...tickets]);
let nextTicket = 0;
let typingTimer = null;

simulateButton.addEventListener("click", submitNextTicket);
resetButton.addEventListener("click", resetDemo);

async function submitNextTicket() {
  if (nextTicket >= ticketOrder.length) return;

  const ticket = ticketOrder[nextTicket];
  nextTicket += 1;
  setControlsBusy(true);
  hideNotification();
  resetFlow();
  updateProgress();

  generationPanel.classList.remove("is-submitted");
  generationPanel.classList.add("is-generating");
  generationLabel.textContent = "Generating ticket";
  generationDetail.textContent = `${clientName(ticket.reporter)} · ${ticket.date}`;
  await startTyping(ticket.message);
  markSubmitted(ticket);

  activityMessage.textContent = `Foundry is analysing ${ticket.id}.`;
  setFlow(
    "is-analysing",
    "received",
    "Analysing ticket",
    "Waiting for the Foundry response…",
  );

  try {
    const result = await routeTicket(ticket.message);
    routeSuccessfulTicket(ticket, result);
  } catch {
    routeToServiceDesk(ticket);
  } finally {
    setControlsBusy(false);
    updateCounts();
  }
}

async function routeTicket(ticket) {
  const response = await fetch("/api/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // A non-JSON upstream response is handled by the normal fallback below.
  }

  if (!response.ok) {
    throw new Error(payload.detail || "No response was received from the AI router.");
  }

  const queue = queueForCategory(payload.category);
  if (!queue) {
    throw new Error("The AI router returned an unknown support category.");
  }

  return { ...payload, queue };
}

function routeSuccessfulTicket(ticket, result) {
  const manualReview = result.queue === "service_desk";
  const card = buildTicketCard(ticket);

  if (manualReview) {
    card.classList.add("is-review");
    card.querySelector(".routing-state").textContent = "Manual review";
  } else {
    const confidence = normaliseConfidence(result.confidence);
    card.classList.add("is-routed");
    card.querySelector(".routing-state").textContent = `Confidence ${confidence}%`;
  }

  addToQueue(result.queue, card);
  setFlow(
    "is-routing",
    "routed",
    "Routing complete",
    `${ticket.id} → ${queueName(result.queue)}`,
  );
  activityMessage.textContent = `${ticket.id} assigned to ${queueName(result.queue)}.`;
}

function routeToServiceDesk(ticket) {
  const card = buildTicketCard(ticket);
  card.classList.add("is-review");
  card.querySelector(".routing-state").textContent = "Manual review";
  addToQueue("service_desk", card);

  setFlow(
    "is-error",
    "routed",
    "Manual routing required",
    `${ticket.id} → ${queueName("service_desk")}`,
  );
  activityMessage.textContent = `${ticket.id} sent to the general queue.`;
  showNotification(
    "No model was detected. The ticket is being routed to Service Desk for manual assignment to the appropriate team.",
  );
}

function markSubmitted(ticket) {
  generationTyped.textContent = ticket.message;
  generationPanel.classList.remove("is-generating");
  generationPanel.classList.add("is-submitted");
}

function setControlsBusy(busy) {
  simulateButton.disabled = busy || nextTicket >= ticketOrder.length;
  resetButton.disabled = busy;

  if (busy) {
    simulateButton.querySelector("span").textContent = "Submitting ticket…";
  } else if (nextTicket >= ticketOrder.length) {
    simulateButton.querySelector("span").textContent = "All tickets submitted";
  } else {
    simulateButton.querySelector("span").textContent = "Simulate ticket submission";
  }
}

function setFlow(state, progress, status, detail) {
  foundryFlow.classList.remove(
    "is-ingesting",
    "is-analysing",
    "is-routing",
    "is-complete",
    "is-error",
  );
  foundryFlow.classList.add(state);
  foundryFlow.dataset.progress = progress;
  flowStatus.textContent = status;
  flowDetail.textContent = detail;
}

function resetFlow() {
  foundryFlow.classList.remove(
    "is-ingesting",
    "is-analysing",
    "is-routing",
    "is-complete",
    "is-error",
  );
  delete foundryFlow.dataset.progress;
  flowStatus.textContent = "Waiting for a ticket";
  flowDetail.textContent = "The model selects one queue.";
}

function startTyping(message) {
  stopTyping();
  generationTyped.textContent = "";

  return new Promise((resolve) => {
    let position = 0;
    const interval = Math.max(18, Math.floor(2500 / message.length));
    typingTimer = window.setInterval(() => {
      position += 1;
      generationTyped.textContent = message.slice(0, position);

      if (position >= message.length) {
        stopTyping();
        resolve();
      }
    }, interval);
  });
}

function stopTyping() {
  if (typingTimer === null) return;
  window.clearInterval(typingTimer);
  typingTimer = null;
}

function buildTicketCard(ticket) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.ticketId = ticket.id;
  card.querySelector(".ticket-id").textContent = ticket.id;
  card.querySelector(".ticket-date").textContent = ticket.date;
  card.querySelector(".ticket-message").textContent = ticket.message;
  card.querySelector(".reporter-name").textContent = clientName(ticket.reporter);
  card.querySelector(".reporter-avatar").textContent = initials(ticket.reporter);
  return card;
}

function addToQueue(queue, card) {
  const list = document.querySelector(`#${queue}-list`);
  if (!list) throw new Error(`Unknown queue: ${queue}`);
  list.querySelector(".empty-state")?.remove();
  list.prepend(card);
}

function updateProgress() {
  progressLabel.textContent = `${nextTicket} / ${ticketOrder.length}`;
  progressBar.style.width = `${(nextTicket / ticketOrder.length) * 100}%`;
}

function updateCounts() {
  let total = 0;
  document.querySelectorAll("[data-queue]").forEach((queue) => {
    const count = queue.querySelectorAll(".ticket-card").length;
    queue.querySelector(".queue-count").textContent = count;
    total += count;
  });
  totalCount.textContent = total;
}

function resetDemo() {
  stopTyping();
  ticketOrder = shuffle([...tickets]);
  nextTicket = 0;
  document.querySelectorAll(".ticket-card").forEach((card) => card.remove());
  restoreEmptyStates();
  hideNotification();
  simulateButton.disabled = false;
  resetButton.disabled = false;
  simulateButton.querySelector("span").textContent = "Simulate ticket submission";
  generationPanel.classList.remove("is-generating", "is-submitted");
  generationLabel.textContent = "Ticket generator";
  generationDetail.textContent = "Waiting";
  generationTyped.textContent = "";
  activityMessage.textContent = "Ready for a ticket.";
  resetFlow();
  updateProgress();
  updateCounts();
}

function restoreEmptyStates() {
  const labels = {
    service_desk: "No tickets",
    billing: "No tickets",
    technical: "No tickets",
    people: "No tickets",
  };

  Object.entries(labels).forEach(([queue, label]) => {
    const list = document.querySelector(`#${queue}-list`);
    if (list.querySelector(".empty-state")) return;
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = label;
    list.append(empty);
  });
}

function showNotification(text) {
  notificationMessage.textContent = text;
  notification.hidden = false;
}

function hideNotification() {
  notification.hidden = true;
  notificationMessage.textContent = "";
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
  return items;
}

function normaliseConfidence(confidence) {
  const value = Number(confidence);
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

function queueForCategory(category) {
  return {
    billing: "billing",
    technical: "technical",
    general: "people",
    needs_review: "service_desk",
  }[category];
}

function initials(name) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function clientName(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)[0]}`;
}

function queueName(queue) {
  return {
    service_desk: "Service Desk Support – General Queue",
    billing: "Billing and Payments Support",
    technical: "Technical Infrastructure Support",
    people: "People & Culture Support",
  }[queue];
}
