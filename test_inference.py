import json
import asyncio
import sys
import pandas as pd
import numpy as np
import pickle

# Mock pyodide
class MockResp:
    def __init__(self, filename):
        self.filename = filename
        self.status = 200
    async def bytes(self):
        with open("web-app/public/" + self.filename, "rb") as f:
            return f.read()

class MockHttp:
    async def pyfetch(self, url):
        return MockResp(url)

class MockPyodide:
    http = MockHttp()

sys.modules["pyodide"] = MockPyodide()
sys.modules["pyodide.http"] = MockPyodide().http

# Load inference.py by executing it
with open("web-app/public/inference.py", "r") as f:
    code = f.read()

namespace = {}
exec(code, namespace)

async def run_test():
    input_data = {
      "state": "maharashtra",
      "Age": "69",
      "Gender": "Female",
      "Geography": "Urban",
      "District": "Jalgaon",
      "Caste": "Others",
      "Occupation": "Housewife"
    }
    namespace['INPUT_DATA'] = json.dumps(input_data)
    result = await namespace['main']()
    print("Result:", result)

asyncio.run(run_test())
