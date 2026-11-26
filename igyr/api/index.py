"""
Vercel Serverless Function Entrypoint for IGYR Smart Platform
"""

import sys
from pathlib import Path
from http.server import BaseHTTPRequestHandler

# Add project root to sys.path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# Import main request handler
from server import IgyrRequestHandler

class handler(IgyrRequestHandler):
    """
    Top-level handler class recognized by Vercel's Python runtime.
    Inherits all API endpoints and CORS handling from IgyrRequestHandler.
    """
    pass

# Aliases for Vercel runtime detection
app = handler
application = handler
