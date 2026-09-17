from flask import Blueprint, request, jsonify
from models.equipment import EquipmentCreate
from services.equipment_service import create_equipment

equipment_bp = Blueprint('equipment', __name__, url_prefix='/api/equipment')

@equipment_bp.route('', methods=['POST'])
def create_equipment_route():
    try:
        # Parse and validate the incoming JSON payload
        data = request.get_json()
        equipment_data = EquipmentCreate(**data)

        # Call the service layer to handle the logic
        created_equipment = create_equipment(equipment_data)

        # Return the created equipment as a JSON response
        return jsonify(created_equipment), 201
    except ValueError as e:
        # Handle validation errors
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        # Handle unexpected errors
        return jsonify({"error": "An unexpected error occurred"}), 500