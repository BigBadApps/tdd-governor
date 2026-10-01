from service import Worker, execute


def test_worker_positive():
    assert Worker().execute(10) == 10


def test_function_positive():
    assert execute(10) == 10
