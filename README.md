# Home Energy Modelling

A web application for visualizing floor plans and calculating thermal properties of buildings.

## Features

- **Floor Plan**: Create and edit 2D floor plans with multiple storeys, rooms, and openings (windows/doors)
- **3D View**: Interactive 3D visualization of the floor plan with realistic room geometry
- **U-Value Calculator**: Calculate and manage thermal properties (U-values) for building elements

## 3D View

The 3D view provides an interactive three-dimensional visualization of your floor plan:

- **Rotate**: Click and drag to rotate the view
- **Zoom**: Use mouse wheel to zoom in/out
- **Multi-storey**: Automatically displays all storeys from your floor plan
- **Room Details**: Shows walls with proper window and door openings, floors, and ceilings

### How to Use

1. Create rooms in the **Floor Plan** tab
2. Add windows and doors with appropriate dimensions and sill heights
3. Switch to the **3D View** tab to see your design in 3D

## Tech Stack

- React 19
- Vite
- Three.js (for 3D visualization)
- localStorage (for persistence)

