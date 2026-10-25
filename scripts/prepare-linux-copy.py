"""Copy sources into an isolated Linux build tree, never copy native dependencies."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
destination = root / '.test-artifacts' / 'linux' / 'source'
destination.mkdir(parents=True, exist_ok=True)
for name in ['electron', 'src', 'shared', 'tests', 'scripts', 'docs', 'build']:
    shutil.copytree(root / name, destination / name, dirs_exist_ok=True)
for name in ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.backend.json', 'tsconfig.tests.json', 'vite.config.ts', 'index.html', 'README.md', 'MILESTONES.md']:
    shutil.copy2(root / name, destination / name)
print(destination)
