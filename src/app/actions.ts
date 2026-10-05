"use server";
import { revalidatePath } from "next/cache";
import * as db from "@/lib/db";
import { detectSource } from "@/lib/metadata";

export async function addManualItem(form: { url: string; title: string; summary?: string; category?: string; tags?: string[]; notes?: string }) {
  await db.upsertItem({
    url: form.url, source: detectSource(form.url), title: form.title || "Untitled",
    author: null, thumbnail: null, summary: form.summary ?? null,
    category: form.category || "Uncategorized", tags: form.tags ?? [], notes: form.notes ?? null,
    origin: "manual",
  });
  revalidatePath("/");
}
export async function saveNotes(id: string, notes: string) { await db.updateItem(id, { notes }); revalidatePath(`/item/${id}`); }
export async function deleteItem(id: string) { await db.removeItem(id); revalidatePath("/"); }
