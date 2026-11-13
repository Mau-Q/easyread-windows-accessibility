"""有限队列、退避与并发回落。模型和每批内容不随调度变化。"""
from __future__ import annotations

from collections import deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait


MAX_CONCURRENCY = 32


def concurrency(cfg):
    return max(1, min(MAX_CONCURRENCY, int(cfg.get("concurrency") or 1)))


def run(batches, work, cfg, cancel, completed):
    """work 返回 (失败段落, 是否遇到临时故障)。只提交当前可运行的批次。"""
    maximum = concurrency(cfg)
    allowed = maximum
    adaptive = cfg.get("html_adaptive", True)
    successes = 0
    pending = deque(batches)
    active = {}
    with ThreadPoolExecutor(max_workers=maximum) as pool:
        try:
            while pending or active:
                if cancel.is_set():
                    from .engines import Cancelled
                    raise Cancelled()
                while pending and len(active) < allowed:
                    batch = pending.popleft()
                    active[pool.submit(work, batch)] = batch
                done, _ = wait(active, return_when=FIRST_COMPLETED)
                for future in done:
                    batch = active.pop(future)
                    failed, temporary = future.result()
                    if adaptive and temporary:
                        allowed = max(1, allowed // 2)
                        successes = 0
                    elif adaptive and not failed:
                        successes += 1
                        if successes >= max(4, allowed * 2) and allowed < maximum:
                            allowed = min(maximum, allowed + 1)
                            successes = 0
                    completed(batch, failed, allowed)
        except BaseException:
            cancel.set()
            for future in active:
                future.cancel()
            raise
