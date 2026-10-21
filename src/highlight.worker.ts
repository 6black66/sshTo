import { highlightCode } from "./highlight-code";
self.onmessage = async (
  event: MessageEvent<{ text: string; language: string }>,
) => {
  try {
    self.postMessage({
      html: await highlightCode(event.data.text, event.data.language),
    });
  } catch {
    self.postMessage({ error: true });
  }
};
