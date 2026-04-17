# TuneBox (Vercel compatible)

This app resolves YouTube media with ZylaLabs and redirects to a downloadable URL.

For YouTube links, it resolves the media URL via the ZylaLabs endpoint:
`GET https://zylalabs.com/api/11016/youtube+download+and+info+api/20761/download`

## Requirements

- Node.js 18+ (for native `fetch`)

## Run

```bash
npm install
npm start
```

Set your API key first:

```bash
# PowerShell
$env:ZYLALABS_API_KEY="your_api_key"
# Optional (if endpoint expects a different query field than "url")
$env:ZYLALABS_SOURCE_QUERY_PARAM="url"
```

Then open: `http://127.0.0.1:3000`

## API

- `POST /api/resolve`
  - body: `{ "sourceUrl": "https://youtube.com/watch?v=...", "format": "mp3" }`
  - response: `{ "success": true, "format": "mp3", "downloadUrl": "https://..." }`

Supported `format` values:
- Audio: `mp3`, `m4a`, `flac`, `opus`, `wav`
- Video: `360`, `480`, `720`, `1080`, `1440`, `2160`

## Vercel deployment

Set these Project Environment Variables in Vercel:
- `ZYLALABS_API_KEY` (required)
- `ZYLALABS_SOURCE_QUERY_PARAM` (optional, default: `url`)
- `ZYLALABS_FORMAT_QUERY_PARAM` (optional, default: `format`)

## ZylaLabs YouTube request/response contract

- Request params: `url`, `format`
- Example response:

```json
{
  "success": true,
  "id": "bba1ef8d8504b060c3d03784948113388b46b1eb",
  "image": "https://i.ytimg.com/vi/6WBe9mnDB1c/hqdefault.jpg",
  "progress_url": "https://youtube-api-progress-copy-development.up.railway.app/api/progress?id=bba1ef8d8504b060c3d03784948113388b46b1eb"
}
```

The server now calls `progress_url` until a downloadable media URL is returned.

## Added MCP skill (ZylaLabs)

- Skill path: `.github/skills/zylalabs-mcp-wrapper/SKILL.md`
- MCP config template: `zylalabs-mcp-config.json`

For Copilot cloud agent:
1. Open repository settings -> **Copilot** -> **Cloud agent** -> **MCP configuration**.
2. Paste the JSON from `zylalabs-mcp-config.json`.
3. In repository **Environments** -> `copilot`, add secret:
   - `COPILOT_MCP_ZYLALABS_API_KEY`
