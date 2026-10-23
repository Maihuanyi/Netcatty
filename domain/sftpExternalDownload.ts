/** Remote names are used verbatim on Windows; never silently rename a path. */
export function assertWindowsDownloadName(name: string): void {
  if (!name || name === '.' || name === '..' || [...name].some(char => char.charCodeAt(0) < 32)
      || /[<>:"/\\|?*]/.test(name)
      || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(`Cannot download this file name on Windows: ${name}`);
  }
}
