const out = await Bun.build({ entrypoints: ["src/main.ts"], minify: true, target: "browser", format: "iife" });
if (!out.success) {
  console.error(out.logs);
  process.exit(1);
}
const js = (await out.outputs[0].text()).replace(/<\/script/gi, "<\\/script");
const html = await Bun.file("index.template.html").text();
await Bun.write("index.html", html.replace("/*BUNDLE*/", () => js));
console.log("index.html", ((js.length + html.length) / 1024).toFixed(0), "KB");
