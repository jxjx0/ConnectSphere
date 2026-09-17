import axios from 'axios';

export const createEquipment = async (equipmentData) => {
  const response = await axios.post('/api/equipment', equipmentData);
  return response.data;
};