/** Count images once, including protocol-relative URLs and srcset-only tracking images. */
export function countRemoteImages(html: string): number {
  if (!html) return 0;
  const template = document.createElement('template');
  template.innerHTML = html;
  const remote = (src: string) => /^https?:\/\/|^\/\//i.test(src.trim());
  return [...template.content.querySelectorAll('img')].filter((image) =>
    remote(image.getAttribute('src') ?? '') || (image.getAttribute('srcset') ?? '').split(',').some((candidate) => remote(candidate.trim().split(/\s+/)[0] ?? '')),
  ).length;
}
