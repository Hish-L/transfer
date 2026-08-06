// The landing page is static apart from one affordance: the terminal
// one-liners are the thing people came for, and selecting one by hand out of a
// horizontally-scrolling <code> on a phone is miserable.

for (const copy of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const cmd = document.getElementById(copy.dataset.copy ?? "");
  if (!cmd) continue;

  copy.addEventListener("click", () => {
    void navigator.clipboard
      ?.writeText(cmd.textContent ?? "")
      .then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1400);
      })
      .catch(() => {
        // Clipboard access can be refused outright (permissions, insecure
        // origin). Selecting the text is the fallback that always works.
        copy.textContent = "Select it";
        const range = document.createRange();
        range.selectNodeContents(cmd);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
  });
}
