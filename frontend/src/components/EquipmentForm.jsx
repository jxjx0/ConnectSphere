import React, { useState } from 'react';

const EquipmentForm = ({ onSubmit }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('Functional');
  const [errors, setErrors] = useState({});

  const validate = () => {
    const newErrors = {};
    if (!name.trim()) newErrors.name = 'Name is required';
    if (!type) newErrors.type = 'Type is required';
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validate()) return;
    onSubmit({ name, type, maintenance_status: status });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <label>Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {errors.name && <p className="error">{errors.name}</p>}
      </div>
      <div>
        <label>Type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="" disabled>Select Type</option>
          <option value="Audio">Audio</option>
          <option value="Visual">Visual</option>
          <option value="Staging">Staging</option>
        </select>
        {errors.type && <p className="error">{errors.type}</p>}
      </div>
      <div>
        <label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="Functional">Functional</option>
          <option value="Under Repair">Under Repair</option>
          <option value="Decommissioned">Decommissioned</option>
        </select>
      </div>
      <button type="submit">Create Equipment</button>
    </form>
  );
};

export default EquipmentForm;