from flask import Flask, render_template
from flask_sqlalchemy import SQLAlchemy

app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///erp.db"
db = SQLAlchemy(app)

class ERPSystem:
    def __init__(self):
        self.modules = []
    def add_module(self, module):
        self.modules.append(module)
    def remove_module(self, module):
        self.modules.remove(module)
    def run(self):
        for module in self.modules:
            module.run()

@app.route("/")
def index():
    return render_template("index.html")

if __name__ == "__main__":
    app.run(debug=True)