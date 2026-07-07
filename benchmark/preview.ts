// Minimal static server just for previewing report.html during development.
Bun.serve({
  port: Number(process.env.PORT ?? 4321),
  fetch() {
    return new Response(Bun.file(`${import.meta.dir}/report.html`), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});
console.log("report preview on :4321");
