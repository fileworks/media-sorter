"""Stateless, dependency-free helper functions shared across services.

Modules here must not import from ``app.services`` so they stay free of
circular-import risk and trivially unit-testable.
"""
