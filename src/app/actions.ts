// Were Next server actions; now plain calls to the card API (server/app.ts).
export async function saveNotes(id: string, notes: string): Promise<void> {
  const res = await fetch(`/api/card/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes }),
  });
  if (!res.ok) throw new Error(`saveNotes ${res.status}`);
}

export async function deleteItem(id: string): Promise<void> {
  const res = await fetch(`/api/card/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`deleteItem ${res.status}`);
}
