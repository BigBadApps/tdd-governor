"""Service module with class and function."""


class Worker:
    def execute(self, val: int) -> int:
        if val < 0:
            return 0
        return val


def execute(val: int) -> int:
    if val > 100:
        return 100
    return val
