import { Hono } from "hono";

const root = new URL("../../dist/", import.meta.url);
const docs = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OAI Codex · API</title></head><body><div id="app"></div><script src="/assets/scalar.js"></script><script>Scalar.createApiReference('#app',{url:'/openapi.json',theme:'kepler',proxyUrl:'',persistAuth:false,hideClientButton:true,hideTestRequestButton:false,customCss:'.scalar-app{--scalar-font:system-ui,sans-serif}'})</script></body></html>`;

export function staticRoutes(dashboard: boolean, documentation: boolean) {
  const app = new Hono();
  if (documentation) app.get("/docs", (context) => context.html(docs));
  app.get("/assets/:name", async (context) => {
    const name = context.req.param("name");
    if (!/^[a-zA-Z0-9_.-]+\.(js|css|woff2)$/.test(name)) return context.notFound();
    if (name === "scalar.js" ? !documentation : !dashboard) return context.notFound();
    const file = Bun.file(new URL(`assets/${name}`, root));
    if (!(await file.exists())) return context.notFound();
    return new Response(file, { headers: { "cache-control": "no-cache" } });
  });
  if (dashboard)
    app.get("/", async (context) => {
      const file = Bun.file(new URL("index.html", root));
      if (!(await file.exists()))
        return context.text("Dashboard non compilé. Lancez bun run build.", 503);
      return new Response(file, { headers: { "cache-control": "no-cache" } });
    });
  return app;
}
