# Share-sheet capture setup

Two zero-risk ways to push a reel into Reel Vault the moment you see it.

## Android (PWA share target) — already wired

1. Open Reel Vault in Chrome on the phone and "Add to Home screen" (must be
   installed for the share target to register).
2. In Instagram: Share → ⋯ → **ReelVault**.
3. The `/add` page opens with the URL pre-filled (parsed out of the shared
   `text` — Android rarely fills the `url` param), metadata fetched, AI
   enrichment suggested. Tap **Save to vault**.

Note: the phone must reach the app's URL. While the app runs only on
`localhost`, use the same Wi-Fi + your machine's LAN IP, or a tunnel
(e.g. `cloudflared tunnel` / `tailscale serve`).

## iPhone (iOS Shortcut → POST /api/share)

iOS PWAs cannot register as share targets, so use a Shortcut:

1. Ensure `.env.local` has `SHARE_TOKEN=...` (one was generated for you) and
   restart the dev server.
2. On the iPhone open **Shortcuts** → **+** → name it "Save to Reel Vault".
3. Shortcut settings (ⓘ): enable **Show in Share Sheet**; set accepted types
   to **URLs** and **Text**.
4. Add action **Get Contents of URL**:
   - URL: `https://<your-app-host>/api/share`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <SHARE_TOKEN value>`
   - Request Body: **JSON**, one field: `text` = **Shortcut Input** (magic variable)
5. (Optional) Add **Show Notification** with `Get Contents of URL` result.
6. In Instagram: Share → **Share to...** → **Save to Reel Vault**.

The endpoint extracts the first URL from whatever arrives (URL, text, or
text containing a URL), saves it with best-effort title/thumbnail, and the
enrich-pending worker fills in summary/category/tags later.

### Test it from a terminal

```bash
curl -X POST http://localhost:3000/api/share \
  -H "Authorization: Bearer $SHARE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text": "check this https://www.instagram.com/reel/XXXX/"}'
```
