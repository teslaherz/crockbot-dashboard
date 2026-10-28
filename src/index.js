export default {
async fetch() {
return new Response(
`<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crockbot Dashboard</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#f8fafc;"><h1>Hallo Welt</h1></body></html>`,
  { headers: { "content-type": "text/html; charset=utf-8" } }
);
}
};








