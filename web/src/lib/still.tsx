import { useEffect, useState, type ImgHTMLAttributes } from "react";

const stills = new Map<string, string | null>();

/** Options -> Sicherheit -> "Cache löschen". */
export function clearStillCache(): void {
  stills.clear();
}

/** First frame of an (animated) image as a PNG data URL, or null when the
 *  browser won't let us read it (cross-origin image without CORS). */
function freeze(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        resolve(canvas.toDataURL());
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** <img> that shows only the first frame when `still` is set (GIF animation off).
 *  Falls back to the original image when it can't be frozen. */
export function StillImg({ still, src, ...rest }: ImgHTMLAttributes<HTMLImageElement> & { still: boolean; src: string }) {
  const [frozen, setFrozen] = useState(() => (still ? stills.get(src) : undefined));
  useEffect(() => {
    if (!still) return;
    if (stills.has(src)) {
      setFrozen(stills.get(src));
      return;
    }
    let live = true;
    void freeze(src).then((url) => {
      stills.set(src, url);
      if (live) setFrozen(url);
    });
    return () => {
      live = false;
    };
  }, [src, still]);
  // While freezing, render nothing rather than letting the animation start.
  if (still && frozen === undefined) return null;
  return <img src={still && frozen ? frozen : src} {...rest} />;
}
