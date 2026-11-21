/* Runs in an opaque, script-only iframe. Only the two bundled scripts are allowed by its CSP. */
(async () => {
  const host = document.querySelector("main");
  const source = document.querySelector("template").content.textContent;
  try {
    window.mermaid.initialize({
      startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
      theme: document.documentElement.dataset.dark === "true" ? "dark" : "default",
      flowchart: { htmlLabels: false },
    });
    const { svg } = await window.mermaid.render("diagram", source);
    host.innerHTML = svg;
  } catch {
    host.textContent = "图表语法无法解析。";
    const code = document.createElement("pre");
    code.textContent = source;
    host.appendChild(code);
  }
  parent.postMessage({ type: "diagram-size", height: document.body.scrollHeight }, "*");
})();
