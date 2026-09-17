import React, { useState } from 'react';
import EquipmentForm from '../components/EquipmentForm';
import { createEquipment } from '../api/equipment';
import { useNavigate } from 'react-router-dom';

const EquipmentProfilePage = () => {
  const navigate = useNavigate();
  const [error, setError] = useState(null);

  const handleSubmit = async (equipmentData) => {
    try {
      await createEquipment(equipmentData);
      navigate('/equipment'); // Redirect to the equipment catalogue page
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <h1>Create Equipment Profile</h1>
      {error && <p className="error">{error}</p>}
      <EquipmentForm onSubmit={handleSubmit} />
    </div>
  );
};

export default EquipmentProfilePage;