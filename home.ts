// The landing page is static apart from one affordance: the terminal
// one-liner is the thing people came for, and selecting it by hand out of a
// horizontally-scrolling <code> on a phone is miserable.

const cmd = document.getElementById("cli-cmd");
const copy = document.getElementById("cli-copy") as HTMLButtonElement | null;

if (cmd && copy) {
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
