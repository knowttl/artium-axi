#!/usr/bin/env python3
import json
import os
import sys

# Falcon's Python address-space limit cannot host Node's V8 reservations.
assert sys.argv[1] == "env"
print(json.dumps(dict(os.environ)))
