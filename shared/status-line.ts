// The status line is an error channel, not a readout. The numbered steps say
// what to do, the HUD and the result card say what happened, so routine
// progress messages went from noise to nothing: setStatus() hides the element
// again. Only showError() puts it on screen, which is also what makes a failure
// impossible to miss (see .status-line in theme.css, which is styled as an
// error only). setStatus() keeps its message parameter so the call sites read
// unchanged, and ignores it.

export interface StatusLine {
  setStatus(message: string): void;
  showError(message: string): void;
}

export function statusLine(el: HTMLElement): StatusLine {
  return {
    setStatus(): void {
      el.textContent = "";
      el.hidden = true;
    },
    showError(message: string): void {
      el.textContent = `✗ ${message}`;
      el.hidden = false;
    },
  };
}
