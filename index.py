"""
Vercel Serverless Function Entrypoint for IGYR Smart Platform
"""

import os
import sys
from pathlib import Path

# Add project root to sys.path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Import the main request handler from server.py
from server import IgyrRequestHandler

# Vercel looks for 'handler' as a BaseHTTPRequestHandler subclass
class handler(IgyrRequestHandler):
    def __init__(self, *args, **kwargs):
        # On Vercel, static files are served by Vercel CDN, but pass ROOT_DIR as fallback directory
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)
