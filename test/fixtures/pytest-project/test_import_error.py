from does_not_exist import missing  # deliberate collection error


def test_never_runs():
    missing()
