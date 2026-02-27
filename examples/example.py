"""
Example: nicegui-p360 viewer

Run with:
    python example.py

Then open http://localhost:8081 in your browser.

Place your sprite.webp in the same directory, or update the path below.
"""

from pathlib import Path
from nicegui import app, ui
from nicegui_p360.viewer import Viewer360

# Serve the directory containing your sprite as a static path
app.add_static_files('/static', Path(__file__).parent)


@ui.page('/')
def index():
    with ui.column().classes('items-center justify-center min-h-screen gap-6'):
        ui.label('Soulie Ceramics').classes('text-2xl font-serif tracking-widest opacity-60')

        # Sprite mode (recommended for production)
        Viewer360(
            sprite='/static/sprite.webp',
            background='#f0e6d2',  # set to 'transparent' to show the page background
            drag_sensitivity=8,
            auto_spin=False,        # set e.g. 0.5 for half a rotation per second
        )

        ui.label('← drag to rotate →').classes('text-xs tracking-widest uppercase opacity-30')


ui.run(title='360° Viewer Example', port=8081)
