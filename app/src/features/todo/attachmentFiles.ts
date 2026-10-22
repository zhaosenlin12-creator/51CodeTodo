const MAX_BYTES = 32 * 1024 * 1024;

/** User-selected images are decoded locally and stored in the existing PNG store. */
export async function attachmentFileToPng(file: File): Promise<string> {
  if (!/\.(png|jpe?g|bmp|gif|webp)$/i.test(file.name)) throw new Error("请选择 PNG、JPG、BMP、GIF 或 WebP 图片");
  if (file.size > MAX_BYTES) throw new Error("图片超过 32 MB，请缩小后添加");
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("图片无法读取，请重新选择"); });
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 32_000_000) throw new Error("截图尺寸过大，请截取需要记录的部分");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("图片转换失败，请重试");
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("图片转换失败")), "image/png"));
    if (blob.size > MAX_BYTES) throw new Error("转换后的图片超过 32 MB，请缩小后添加");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("图片读取失败"));
      reader.readAsDataURL(blob);
    });
  } finally { bitmap.close(); }
}
