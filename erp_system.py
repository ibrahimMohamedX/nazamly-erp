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