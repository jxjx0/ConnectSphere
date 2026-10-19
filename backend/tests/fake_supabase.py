"""A small recording stand-in for the Supabase client used by service tests."""

from types import SimpleNamespace


class FakeQuery:
    def __init__(self, database, table):
        self._database = database
        self.table = table
        self.operation = "select"
        self.payload = None
        self.filters = []

    def select(self, *args):
        self.operation = "select"
        return self

    def insert(self, payload):
        self.operation, self.payload = "insert", payload
        return self

    def update(self, payload):
        self.operation, self.payload = "update", payload
        return self

    def delete(self):
        self.operation = "delete"
        return self

    def _filter(name):
        def apply(self, *args, **kwargs):
            self.filters.append((name, *args))
            return self
        return apply

    eq = _filter("eq")
    neq = _filter("neq")
    in_ = _filter("in_")
    lt = _filter("lt")
    gt = _filter("gt")
    is_ = _filter("is_")
    like = _filter("like")
    order = _filter("order")
    del _filter

    def execute(self):
        self._database.calls.append(self)
        response = self._database.responses.get((self.table, self.operation), [])
        if callable(response):
            response = response(self)
        if isinstance(response, Exception):
            raise response
        return SimpleNamespace(data=response)


class FakeDatabase:
    """Responses are keyed by (table, operation); a callable receives the query."""

    def __init__(self, responses=None):
        self.responses = dict(responses or {})
        self.calls = []
        self.client = SimpleNamespace(table=lambda name: FakeQuery(self, name))

    def calls_to(self, table, operation):
        return [call for call in self.calls if call.table == table and call.operation == operation]
