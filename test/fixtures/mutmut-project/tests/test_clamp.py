from clamp import clamp


def test_clamps_low():
    assert clamp(-5, 0, 10) == 0


def test_in_range():
    assert clamp(5, 0, 10) == 5
