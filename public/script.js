const messagesEl = document.getElementById("messages");
const formEl = document.getElementById("chat-form");
const inputEl = document.getElementById("user-input");

// Full conversation history, sent with every request so the bot has memory
const history = [
  { role: "system", content: "You are a helpful, friendly assistant." },
];

function addMessage(text, role) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const userText = inputEl.value.trim();
  if (!userText) return;

  addMessage(userText, "user");
  history.push({ role: "user", content: userText });
  inputEl.value = "";

  const loadingEl = addMessage("Thinking...", "loading");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });

    const data = await res.json();
    loadingEl.remove();

    if (data.error) {
      addMessage(`Error: ${data.error}`, "bot");
      return;
    }

    addMessage(data.reply, "bot");
    history.push({ role: "assistant", content: data.reply });
  } catch (err) {
    loadingEl.remove();
    addMessage("Error: could not reach the server.", "bot");
  }
});
