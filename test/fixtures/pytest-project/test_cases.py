import time

import pytest

import calc


def test_adds():
    assert calc.add(2, 3) == 5


def test_passes():
    assert 1 == 1


def test_calls_missing_function():
    calc.not_a_function()


@pytest.mark.timeout(0.2)
def test_times_out():
    time.sleep(2)


@pytest.mark.skip(reason="fixture")
def test_skipped():
    pass


class TestGroup:
    def test_in_class(self):
        assert calc.add(1, 1) == 2
