try:
    import tdd_governor_pytest  # noqa: F401

    pytest_plugins = ["tdd_governor_pytest"]
except ImportError:
    pass
