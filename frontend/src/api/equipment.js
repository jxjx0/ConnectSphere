import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000',
});

export const createEquipment = async (equipmentData) => {
  // Grab the token Flask returned during login
  const token = localStorage.getItem('connectsphere.token'); 

  const response = await api.post('/api/equipment', equipmentData, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  return response.data;
};

export const getEquipment = async () => {
    const token = localStorage.getItem('connectsphere.token');
    const response = await api.get('/api/equipment', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data;
  };


  export const updateEquipment = async (id, equipmentData) => {
    const token = localStorage.getItem('connectsphere.token');
    const response = await api.put(`/api/equipment/${id}`, equipmentData, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data;
  };