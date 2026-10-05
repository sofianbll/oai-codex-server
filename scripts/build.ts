import { cp, mkdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const output = new URL("dist/assets/", root);
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [new URL("src/ui/main.ts", root).pathname],
  outdir: output.pathname,
  target: "browser",
  minify: true,
  naming: "[name].[ext]",
});
if (!result.success) throw new AggregateError(result.logs, "Dashboard build failed");
await cp(new URL("src/ui/index.html", root), new URL("dist/index.html", root));
await cp(
  new URL("node_modules/@scalar/api-reference/dist/browser/standalone.js", root),
  new URL("dist/assets/scalar.js", root),
);
console.log(`Dashboard built (${result.outputs.length} files); Scalar bundled locally.`);
