"""Duck image (鸭鸭图) LSB steganography decoder — decode-only."""

from __future__ import annotations

import hashlib
import io
import struct
from typing import Optional, Tuple

import numpy as np
from PIL import Image

WATERMARK_SKIP_W_RATIO = 0.40
WATERMARK_SKIP_H_RATIO = 0.08


def decode_duck_bytes(png_bytes, password=""):
    # type: (bytes, str) -> Tuple[bytes, str]
    """Decode a duck PNG payload into (media_bytes, extension).

    Tries LSB bit-widths 2, 6, 8 (SS_tools / DuckHideNode compress modes).
    """
    try:
        image = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    except Exception as exc:
        raise ValueError("无效的鸭鸭图文件") from exc

    arr = np.array(image).astype(np.uint8)
    last_error = None  # type: Optional[Exception]
    raw = None  # type: Optional[bytes]
    ext = ""

    for k in (2, 6, 8):
        try:
            header = _extract_payload_with_k(arr, k)
            raw, ext = _parse_header(header, password or "")
            break
        except Exception as exc:
            last_error = exc

    if raw is None:
        raise ValueError(
            str(last_error) if last_error else "解码失败，请检查文件或密码"
        )

    payload, final_ext = _normalize_decoded_payload(raw, ext)
    return payload, final_ext or "bin"


def _extract_payload_with_k(arr: np.ndarray, k: int) -> bytes:
    h, w, c = arr.shape
    skip_w = int(w * WATERMARK_SKIP_W_RATIO)
    skip_h = int(h * WATERMARK_SKIP_H_RATIO)
    mask2d = np.ones((h, w), dtype=bool)
    if skip_w > 0 and skip_h > 0:
        mask2d[:skip_h, :skip_w] = False
    mask3d = np.repeat(mask2d[:, :, None], c, axis=2)
    flat = arr.reshape(-1)
    idxs = np.flatnonzero(mask3d.reshape(-1))
    vals = (flat[idxs] & ((1 << k) - 1)).astype(np.uint8)
    unpacked = np.unpackbits(vals, bitorder="big").reshape(-1, 8)[:, -k:]
    bits = unpacked.reshape(-1)
    if len(bits) < 32:
        raise ValueError("图像数据不足")
    length_bytes = np.packbits(bits[:32], bitorder="big").tobytes()
    header_len = struct.unpack(">I", length_bytes)[0]
    total_bits = 32 + header_len * 8
    if header_len <= 0 or total_bits > len(bits):
        raise ValueError("载荷长度异常")
    payload_bits = bits[32 : 32 + header_len * 8]
    return np.packbits(payload_bits, bitorder="big").tobytes()


def _generate_key_stream(password: str, salt: bytes, length: int) -> bytes:
    key_material = (password + salt.hex()).encode("utf-8")
    out = bytearray()
    counter = 0
    while len(out) < length:
        out.extend(hashlib.sha256(key_material + str(counter).encode("utf-8")).digest())
        counter += 1
    return bytes(out[:length])


def _parse_header(header: bytes, password: str) -> Tuple[bytes, str]:
    idx = 0
    if len(header) < 1:
        raise ValueError("文件头损坏")
    has_password = header[0] == 1
    idx += 1

    password_hash = b""
    salt = b""
    if has_password:
        if len(header) < idx + 32 + 16:
            raise ValueError("文件头损坏")
        password_hash = header[idx : idx + 32]
        idx += 32
        salt = header[idx : idx + 16]
        idx += 16

    if len(header) < idx + 1:
        raise ValueError("文件头损坏")
    ext_len = header[idx]
    idx += 1
    if len(header) < idx + ext_len + 4:
        raise ValueError("文件头损坏")
    ext = header[idx : idx + ext_len].decode("utf-8", errors="ignore")
    idx += ext_len
    data_len = struct.unpack(">I", header[idx : idx + 4])[0]
    idx += 4
    data = header[idx:]
    if len(data) != data_len:
        raise ValueError("数据长度不匹配")
    if not has_password:
        return data, ext
    if not password:
        raise ValueError("需要密码")

    check_hash = hashlib.sha256((password + salt.hex()).encode("utf-8")).digest()
    if check_hash != password_hash:
        raise ValueError("密码错误")
    key_stream = _generate_key_stream(password, salt, len(data))
    plain = bytes(a ^ b for a, b in zip(data, key_stream))
    return plain, ext


def _normalize_decoded_payload(raw: bytes, ext: str) -> Tuple[bytes, str]:
    normalized = ext.lower().lstrip(".") or "bin"
    if normalized.endswith(".binpng"):
        original_ext = normalized[: -len(".binpng")].lstrip(".") or "mp4"
        return _binpng_bytes_to_bytes(raw), original_ext
    return raw, normalized


def _binpng_bytes_to_bytes(raw_png: bytes) -> bytes:
    image = Image.open(io.BytesIO(raw_png)).convert("RGB")
    arr = np.array(image).astype(np.uint8)
    return arr.reshape(-1, 3).reshape(-1).tobytes().rstrip(b"\x00")
