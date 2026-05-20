export function createStorefrontToolGroup({
  showProductCollectionTool,
  setFocusProductTool,
}) {
  return [
    showProductCollectionTool,
    setFocusProductTool,
  ].filter(Boolean);
}
