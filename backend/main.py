"""Vercel entrypoint for the backend service (see vercel.json services)."""

from app.main import app

__all__ = ["app"]
