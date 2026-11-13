"""Nonblocking advisory lock, released by closing the file on either platform."""
import os


def try_lock(stream):
    if os.name == "nt":
        import msvcrt
        stream.seek(0, os.SEEK_END)
        if not stream.tell():
            stream.write("0")
            stream.flush()
        stream.seek(0)
        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BlockingIOError("翻译连接正在使用") from error
    else:
        import fcntl
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
