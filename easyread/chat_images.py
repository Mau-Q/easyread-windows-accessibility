"""问 AI 的本地图片附件：保留原始图片，只接收当前论文目录内的附件标识。"""
from __future__ import annotations

import hashlib
import io
import re
import warnings
from pathlib import Path

from PIL import Image, UnidentifiedImageError

MAX_BYTES = 10 * 1024 * 1024
MAX_IMAGES = 4
FORMATS = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}
ID_RE = re.compile(r"[a-f0-9]{64}\.(?:png|jpg|webp)")


def inspect(data):
    if not data or len(data) > MAX_BYTES:
        raise ValueError("每张图片不能超过 10 MB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                if image.format not in FORMATS:
                    raise ValueError("请使用 PNG、JPEG 或 WebP 图片")
                if image.width * image.height > 40_000_000:
                    raise ValueError("图片分辨率过大，请裁剪需要提问的部分")
                fmt, width, height = image.format, image.width, image.height
                image.verify()
        return FORMATS[fmt], width, height
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
        raise ValueError("图片文件损坏或格式不支持") from e


def metadata(ws, image_id, data, name=""):
    (ext, mime), width, height = inspect(data)
    if image_id != hashlib.sha256(data).hexdigest() + "." + ext:
        raise ValueError("图片附件校验失败")
    return {"id": image_id, "url": f"/p/{ws.id}/chat-images/{image_id}", "mime": mime,
            "name": Path(str(name).replace("\\", "/")).name[:100] or "截图." + ext,
            "size": len(data), "width": width, "height": height}


def save(ws, data, name=""):
    (ext, _), _, _ = inspect(data)
    image_id = hashlib.sha256(data).hexdigest() + "." + ext
    folder = ws.root / "chat-images"
    if folder.is_symlink():
        raise ValueError("图片附件目录无效")
    folder.mkdir(exist_ok=True)
    path = folder / image_id
    if path.is_symlink():
        raise ValueError("图片附件路径无效")
    if not path.exists():
        path.write_bytes(data)
    return metadata(ws, image_id, data, name)


def resolve(ws, attachments):
    if not isinstance(attachments, list) or len(attachments) > MAX_IMAGES:
        raise ValueError("一次最多附 4 张图片")
    items, paths = [], []
    for attachment in attachments:
        image_id = attachment.get("id", "") if isinstance(attachment, dict) else ""
        if not isinstance(image_id, str) or not ID_RE.fullmatch(image_id):
            raise ValueError("图片附件标识无效")
        folder = ws.root / "chat-images"
        path = folder / image_id
        if folder.is_symlink():
            raise ValueError("图片附件目录无效")
        if not path.is_file() or path.is_symlink() or path.stat().st_size > MAX_BYTES:
            raise ValueError("找不到图片附件，请重新粘贴")
        items.append(metadata(ws, image_id, path.read_bytes(), attachment.get("name", "")))
        paths.append(path.resolve())
    return items, paths
