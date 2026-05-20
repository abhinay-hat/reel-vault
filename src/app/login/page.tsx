"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passcode }),
    });
    if (res.ok) router.push("/");
    else setError("Wrong passcode");
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <form onSubmit={submit} className="flex flex-col gap-3 w-64">
        <h1 className="text-xl font-bold">Reel Vault</h1>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passcode"
          className="border rounded px-3 py-2"
        />
        {error && <p className="text-red-600 text-sm">{error}</p>}
        <button className="bg-black text-white rounded px-3 py-2">Enter</button>
      </form>
    </main>
  );
}
