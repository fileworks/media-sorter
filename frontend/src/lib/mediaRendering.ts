/** Exercise the same Blob URL loading path as authenticated media previews. */
export async function verifyMediaRendering(): Promise<void> {
  const blob = new Blob(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="black"/></svg>',
    ],
    { type: "image/svg+xml" },
  );
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("MediaSorter could not render a Blob image preview."));
      timer = setTimeout(() => reject(new Error("MediaSorter image rendering timed out.")), 5000);
      image.src = url;
    });
  } finally {
    clearTimeout(timer);
    image.onload = null;
    image.onerror = null;
    image.removeAttribute("src");
    URL.revokeObjectURL(url);
  }
}
