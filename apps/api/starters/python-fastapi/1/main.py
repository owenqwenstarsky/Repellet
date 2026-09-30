from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()

@app.get("/", response_class=HTMLResponse)
def home():
    return "<main style='font-family:system-ui;margin:80px'><h1>Hello from Repellet</h1><p>Edit main.py and refresh your preview.</p></main>"

@app.get("/api/hello")
def hello():
    return {"message": "Hello from FastAPI"}
