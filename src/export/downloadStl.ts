/** BlobをSTLファイルとしてブラウザにダウンロードさせる。 */
export function downloadStl(blob: Blob, filename = "model.stl") {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
