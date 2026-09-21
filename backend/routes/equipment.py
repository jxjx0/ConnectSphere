from flask import Blueprint, request, jsonify
from pydantic import ValidationError
from models.equipment import EquipmentCreate
from services.equipment_service import create_equipment, get_all_equipment
from models.profile import Role
from routes.auth import require_auth
from services import auth_service
from services.auth_service import AuthError
from flask import Blueprint, jsonify, request, g 

from services.equipment_service import (
    create_equipment,
    get_all_equipment,
    update_equipment
)

equipment_bp = Blueprint('equipment', __name__, url_prefix='/api/equipment')

def _validation_messages(error: ValidationError) -> list[str]:
    return [item["msg"].removeprefix("Value error, ") for item in error.errors()]

def _require_tech_support() -> None:
    """Ensure the logged-in user holds the tech_support role."""
    profile = auth_service.get_profile(g.access_token, g.user_id)
    if profile.role != Role.TECH_SUPPORT:
        raise AuthError("Only Tech Support can create equipment.", status_code=403)

@equipment_bp.route('', methods=['POST'])
@require_auth
def create_equipment_route():
    try:
        
        data = request.get_json(silent=True) or {}
        equipment_data = EquipmentCreate(**data)

        _require_tech_support()
        data = request.get_json(silent=True) or {}
        equipment_data = EquipmentCreate(**data)

        
        created_equipment = create_equipment(g.access_token, equipment_data)
        return jsonify(created_equipment), 201

    except AuthError as e:
        return jsonify({"error": e.message}), e.status_code

    except ValidationError as e:
        return jsonify({"errors": _validation_messages(e)}), 400

    except Exception as e:
        
        print("Equipment Creation Error:", str(e))
        return jsonify({"error": str(e)}), 500
    

@equipment_bp.route('', methods=['GET'])
@require_auth
def get_equipment_route():
    try:
        equipment_list = get_all_equipment(g.access_token)
        return jsonify(equipment_list), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    

@equipment_bp.route('/<equipment_id>', methods=['PUT'])
@require_auth
def update_equipment_route(equipment_id):
    _require_tech_support()
    try:
        payload = request.get_json()
        if not payload:
            return jsonify({"error": "No payload provided"}), 400

        updated_data = update_equipment(
            equipment_id,
            payload,
            access_token=g.access_token
        )
        if not updated_data:
            return jsonify({"error": "Equipment not found."}), 404
        return jsonify(updated_data), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500